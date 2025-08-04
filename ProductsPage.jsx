import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Star, ShoppingCart, Filter } from 'lucide-react'

const ProductsPage = () => {
  const [selectedSizes, setSelectedSizes] = useState([])
  const [selectedColors, setSelectedColors] = useState([])
  const [priceRange, setPriceRange] = useState([0, 100])
  const [sortBy, setSortBy] = useState('default')

  // بيانات المنتجات
  const products = [
    {
      id: 1,
      name: 'بوكسر كلاسيكي - أسود',
      price: 25,
      image: '/api/placeholder/300/300',
      rating: 4.8,
      reviews: 124,
      sizes: ['S', 'M', 'L', 'XL'],
      colors: ['أسود'],
      category: 'كلاسيكي'
    },
    {
      id: 2,
      name: 'بوكسر رياضي - أزرق داكن',
      price: 30,
      image: '/api/placeholder/300/300',
      rating: 4.9,
      reviews: 89,
      sizes: ['M', 'L', 'XL', 'XXL'],
      colors: ['أزرق داكن'],
      category: 'رياضي'
    },
    {
      id: 3,
      name: 'بوكسر فاخر - رمادي',
      price: 35,
      image: '/api/placeholder/300/300',
      rating: 4.7,
      reviews: 156,
      sizes: ['S', 'M', 'L', 'XL'],
      colors: ['رمادي'],
      category: 'فاخر'
    },
    {
      id: 4,
      name: 'عبوة متعددة الألوان - 3 قطع',
      price: 75,
      image: '/api/placeholder/300/300',
      rating: 4.9,
      reviews: 203,
      sizes: ['M', 'L', 'XL'],
      colors: ['متعدد'],
      category: 'عبوة'
    },
    {
      id: 5,
      name: 'بوكسر قطني - أبيض',
      price: 28,
      image: '/api/placeholder/300/300',
      rating: 4.6,
      reviews: 98,
      sizes: ['S', 'M', 'L', 'XL', 'XXL'],
      colors: ['أبيض'],
      category: 'كلاسيكي'
    },
    {
      id: 6,
      name: 'بوكسر مرن - كحلي',
      price: 32,
      image: '/api/placeholder/300/300',
      rating: 4.8,
      reviews: 145,
      sizes: ['M', 'L', 'XL'],
      colors: ['كحلي'],
      category: 'رياضي'
    }
  ]

  const sizes = ['S', 'M', 'L', 'XL', 'XXL']
  const colors = ['أسود', 'أبيض', 'رمادي', 'أزرق داكن', 'كحلي', 'متعدد']

  const handleSizeChange = (size, checked) => {
    if (checked) {
      setSelectedSizes([...selectedSizes, size])
    } else {
      setSelectedSizes(selectedSizes.filter(s => s !== size))
    }
  }

  const handleColorChange = (color, checked) => {
    if (checked) {
      setSelectedColors([...selectedColors, color])
    } else {
      setSelectedColors(selectedColors.filter(c => c !== color))
    }
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Sidebar Filters */}
        <div className="lg:w-1/4">
          <div className="bg-card rounded-lg p-6 shadow-sm">
            <div className="flex items-center mb-6">
              <Filter className="h-5 w-5 ml-2" />
              <h2 className="text-xl font-semibold">فلترة المنتجات</h2>
            </div>

            {/* Size Filter */}
            <div className="mb-6">
              <h3 className="font-semibold mb-3">المقاس</h3>
              <div className="space-y-2">
                {sizes.map((size) => (
                  <div key={size} className="flex items-center space-x-2">
                    <Checkbox
                      id={`size-${size}`}
                      checked={selectedSizes.includes(size)}
                      onCheckedChange={(checked) => handleSizeChange(size, checked)}
                    />
                    <label htmlFor={`size-${size}`} className="text-sm">
                      {size}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Color Filter */}
            <div className="mb-6">
              <h3 className="font-semibold mb-3">اللون</h3>
              <div className="space-y-2">
                {colors.map((color) => (
                  <div key={color} className="flex items-center space-x-2">
                    <Checkbox
                      id={`color-${color}`}
                      checked={selectedColors.includes(color)}
                      onCheckedChange={(checked) => handleColorChange(color, checked)}
                    />
                    <label htmlFor={`color-${color}`} className="text-sm">
                      {color}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            {/* Price Range */}
            <div className="mb-6">
              <h3 className="font-semibold mb-3">نطاق السعر</h3>
              <div className="space-y-2">
                <Input
                  type="number"
                  placeholder="الحد الأدنى"
                  value={priceRange[0]}
                  onChange={(e) => setPriceRange([parseInt(e.target.value) || 0, priceRange[1]])}
                />
                <Input
                  type="number"
                  placeholder="الحد الأقصى"
                  value={priceRange[1]}
                  onChange={(e) => setPriceRange([priceRange[0], parseInt(e.target.value) || 100])}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Products Grid */}
        <div className="lg:w-3/4">
          {/* Sort and Search */}
          <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
            <div className="flex items-center gap-4">
              <span className="text-muted-foreground">
                عرض {products.length} منتج
              </span>
            </div>
            <div className="flex items-center gap-4">
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="ترتيب حسب" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">الافتراضي</SelectItem>
                  <SelectItem value="price-low">السعر: من الأقل للأعلى</SelectItem>
                  <SelectItem value="price-high">السعر: من الأعلى للأقل</SelectItem>
                  <SelectItem value="rating">التقييم</SelectItem>
                  <SelectItem value="newest">الأحدث</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Products Grid */}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {products.map((product) => (
              <Card key={product.id} className="group hover:shadow-lg transition-shadow">
                <CardContent className="p-4">
                  <div className="aspect-square bg-secondary/20 rounded-lg mb-4 overflow-hidden">
                    <img
                      src={product.image}
                      alt={product.name}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                    />
                  </div>
                  <h3 className="font-semibold mb-2">{product.name}</h3>
                  <div className="flex items-center mb-2">
                    <div className="flex items-center">
                      {[...Array(5)].map((_, i) => (
                        <Star
                          key={i}
                          className={`h-4 w-4 ${
                            i < Math.floor(product.rating)
                              ? 'text-yellow-400 fill-current'
                              : 'text-gray-300'
                          }`}
                        />
                      ))}
                    </div>
                    <span className="text-sm text-muted-foreground mr-2">
                      ({product.reviews})
                    </span>
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xl font-bold text-primary">
                      {product.price} درهم
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <Button size="sm" className="flex-1">
                      <ShoppingCart className="h-4 w-4 ml-2" />
                      أضف للسلة
                    </Button>
                    <Button variant="outline" size="sm" className="mr-2">
                      عرض التفاصيل
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex justify-center mt-8">
            <div className="flex items-center space-x-2">
              <Button variant="outline" size="sm">السابق</Button>
              <Button variant="default" size="sm">1</Button>
              <Button variant="outline" size="sm">2</Button>
              <Button variant="outline" size="sm">التالي</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ProductsPage

